import {
  decodeEncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import type {
  BrowserCanonicalCtfPositionClaimContext,
  BrowserCanonicalCtfPositionClaimResult,
} from "./browserCtfPositionClaim";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  decodeBrowserProofBackupAuthorityTableRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofBackupAuthorityRow,
  type BrowserProofBackupAuthorityTableRow,
} from "../stores/browser-proof-backup-authority";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import { db, type BitcasterDB } from "../stores/proof-db";
import { useWalletStore } from "../stores/wallet";
import { activeBrowserWalletScopeId } from "./browserWalletProfile";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import { claimPortfolioPosition } from "./browserPortfolioClaim";
import type { BrowserCanonicalCtfPositionClaimTarget } from "./browserCtfPositionClaim";
import {
  startBrowserCtfRemove,
  type BrowserCtfRemoveResult,
  type BrowserCtfRemoveTarget,
} from "./browserCtfRemoveCoordinator";
import { activeBrowserEncryptedWalletBackupV2RuntimeDriver } from "./encryptedWalletBackupDriver";
import { normalizeUrl } from "./url";
import { toSeed } from "./bip39";
import { withWalletProfileLock } from "./walletProfileLock";

const ERROR_MESSAGE_LIMIT = 160;
const REMOVE_PROOF_CHUNK_LIMIT = 512;

export interface BrowserPortfolioRemoveInput {
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
  /** Optional exact identities for a retry. The first action captures them under the lock. */
  readonly targets?: readonly BrowserCanonicalCtfPositionClaimTarget[];
  readonly observedAtMs?: number;
  readonly onCommittedLeg?: BrowserCanonicalCtfPositionClaimContext["onCommittedLeg"];
}

export type BrowserPortfolioRemoveResult =
  | BrowserPortfolioRemoveCompleted
  | BrowserPortfolioRemoveStopped
  | BrowserPortfolioRemovePending
  | BrowserPortfolioRemovePartial
  | BrowserPortfolioRemoveError;

export interface BrowserPortfolioRemoveCompleted {
  readonly kind: "completed";
  readonly committedPayoutAmount: number;
}

export interface BrowserPortfolioRemoveStopped {
  readonly kind: "stopped";
  readonly reason: "winning-payout";
  readonly committedPayoutAmount: number;
}

export interface BrowserPortfolioRemovePending {
  readonly kind: "pending";
  readonly reason:
    | "claim-pending"
    | "managed-removal-pending"
    | "local-removal-pending"
    | "profile-changed";
  readonly committedPayoutAmount: number;
}

export interface BrowserPortfolioRemovePartial {
  readonly kind: "partial";
  readonly reason: "local-removal-pending" | "local-removal-error";
  readonly committedPayoutAmount: number;
  readonly error: { readonly code: "remove-failed"; readonly message: string } | null;
}

export interface BrowserPortfolioRemoveError {
  readonly kind: "error";
  readonly committedPayoutAmount: number;
  readonly error: { readonly code: "remove-failed"; readonly message: string };
}

type CompletedMarker = Extract<BrowserProofBackupAuthorityTableRow, { recordKind: string }>;

interface TargetSnapshot {
  readonly target: BrowserCanonicalCtfPositionClaimTarget;
  readonly removalTarget: BrowserCtfRemoveTarget;
  readonly row: BrowserCustodyProofRow | null;
  readonly authority: BrowserProofBackupAuthorityRow | null;
  readonly completedMarker: CompletedMarker | null;
}

interface CapturedTargetSet {
  readonly snapshots: readonly TargetSnapshot[];
  readonly managedTargets: readonly BrowserCtfRemoveTarget[];
  readonly localTargets: readonly BrowserCtfRemoveTarget[];
  readonly claimRequired: boolean;
  readonly pending: boolean;
}

/**
 * Removes only the exact proof set confirmed by the page.
 *
 * Claiming and managed-backup removal use their existing durable owners. This
 * function only composes their bounded operations and never writes a new saga.
 */
export async function removePortfolioPosition(
  input: BrowserPortfolioRemoveInput,
): Promise<BrowserPortfolioRemoveResult> {
  const mnemonic = useWalletStore.getState().mnemonic;
  if (!mnemonic) return removeError(0, "The wallet profile is unavailable.");
  const requestedTargets = input.targets === undefined ? undefined : validateTargets(input.targets);
  const seed = toSeed(mnemonic.trim().split(/\s+/));
  const scope = browserWalletScope(seed);
  const database = db;
  const mintUrl = normalizeUrl(input.mintUrl);
  const asset = ctfAsset(mintUrl, input.conditionId, input.outcomeCollection);
  const requireProfile = () => {
    if (activeBrowserWalletScopeId() !== scope.scopeId || db !== database) {
      throw new Error("The wallet profile changed during removal.");
    }
  };
  let committedPayoutAmount = 0;

  try {
    requireProfile();
    const captured = await withWalletProfileLock(scope.scopeId, async () => {
      requireProfile();
      const targets =
        requestedTargets ??
        (await capturePositionTargets({
          database,
          scopeId: scope.scopeId,
          mintUrl,
          conditionId: input.conditionId,
          outcomeCollection: input.outcomeCollection,
        }));
      return readCapturedTargets({ database, scopeId: scope.scopeId, asset, targets });
    });
    if (captured.pending) {
      return { kind: "pending", reason: "managed-removal-pending", committedPayoutAmount: 0 };
    }
    const targets = captured.snapshots.map(({ target }) => target);

    if (captured.claimRequired) {
      const claimTargets = captured.snapshots
        .filter(({ row }) => row?.selectability === "selectable" || row?.selectability === "locked")
        .map(({ target }) => target);
      const claim = await claimPortfolioPosition({
        mintUrl,
        conditionId: input.conditionId,
        outcomeCollection: input.outcomeCollection,
        targets: claimTargets,
        stopOnCommittedPayout: true,
        onCommittedLeg: input.onCommittedLeg,
      });
      committedPayoutAmount = claim.committedPayoutAmount;
      const claimResult = claimOutcome(claim);
      if (claimResult !== null) return claimResult;
      requireProfile();
    }

    const terminal = await withWalletProfileLock(scope.scopeId, async () => {
      requireProfile();
      return readTerminalTargets({ database, scopeId: scope.scopeId, asset, targets });
    });
    if (terminal.pending) {
      return { kind: "pending", reason: "claim-pending", committedPayoutAmount };
    }

    if (terminal.managedTargets.length > 0) {
      const driver = activeBrowserEncryptedWalletBackupV2RuntimeDriver(scope.scopeId);
      if (driver === null) {
        return {
          kind: "pending",
          reason: "managed-removal-pending",
          committedPayoutAmount,
        };
      }
      const managedResult = await removeManagedProofsInChunks(
        driver,
        asset,
        terminal.managedTargets,
      );
      if (managedResult.kind === "error") {
        return removeError(committedPayoutAmount, managedResult.message);
      }
      if (managedResult.kind === "pending") {
        return {
          kind: "pending",
          reason: "managed-removal-pending",
          committedPayoutAmount,
        };
      }

      requireProfile();
      const afterManaged = await withWalletProfileLock(scope.scopeId, async () => {
        requireProfile();
        return readTerminalTargets({ database, scopeId: scope.scopeId, asset, targets });
      });
      if (afterManaged.pending || afterManaged.managedTargets.length > 0) {
        return {
          kind: "pending",
          reason: "managed-removal-pending",
          committedPayoutAmount,
        };
      }
      if (afterManaged.localTargets.length === 0) {
        return { kind: "completed", committedPayoutAmount };
      }
      return completeLocalRemoval({
        database,
        scopeId: scope.scopeId,
        asset,
        targets: afterManaged.localTargets,
        committedPayoutAmount,
        observedAtMs: input.observedAtMs,
        requireProfile,
      });
    }

    if (terminal.localTargets.length === 0) {
      return { kind: "completed", committedPayoutAmount };
    }
    return completeLocalRemoval({
      database,
      scopeId: scope.scopeId,
      asset,
      targets: terminal.localTargets,
      committedPayoutAmount,
      observedAtMs: input.observedAtMs,
      requireProfile,
    });
  } catch (error) {
    const message = boundedErrorMessage(error);
    if (message === "The wallet profile changed during removal.") {
      return { kind: "pending", reason: "profile-changed", committedPayoutAmount: 0 };
    }
    return removeError(0, message);
  }
}

function validateTargets(
  targets: readonly BrowserCanonicalCtfPositionClaimTarget[],
): readonly BrowserCanonicalCtfPositionClaimTarget[] {
  if (targets.length === 0) throw new Error("at least one confirmed CTF proof target is required");
  const seen = new Set<string>();
  for (const target of targets) {
    if (
      seen.has(target.proofId) ||
      !Number.isSafeInteger(target.revision) ||
      target.revision < 0 ||
      target.proofId.length === 0 ||
      target.proofFingerprint.length === 0
    ) {
      throw new Error("confirmed CTF proof target is invalid");
    }
    seen.add(target.proofId);
  }
  return targets;
}

const POSITION_CAPTURE_PAGE_LIMIT = 256;
const POSITION_CAPTURE_STATES = [
  "selectable",
  "locked",
  "verified-losing",
  "pending-removal",
] as const;

async function capturePositionTargets(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly mintUrl: string;
  readonly conditionId: string;
  readonly outcomeCollection: string;
}): Promise<readonly BrowserCanonicalCtfPositionClaimTarget[]> {
  const captured = new Map<string, BrowserCanonicalCtfPositionClaimTarget>();
  for (const selectability of POSITION_CAPTURE_STATES) {
    let offset = 0;
    for (;;) {
      const rows: readonly unknown[] = await input.database.custodyProofs
        .where("[scopeId+conditionId+outcomeCollection+selectability]")
        .equals([input.scopeId, input.conditionId, input.outcomeCollection, selectability])
        .offset(offset)
        .limit(POSITION_CAPTURE_PAGE_LIMIT)
        .toArray();
      for (const raw of rows) {
        const row = decodeBrowserCustodyProofRow(raw);
        if (
          row.scopeId !== input.scopeId ||
          row.assetKind !== "conditional" ||
          row.conditionId !== input.conditionId ||
          row.outcomeCollection !== input.outcomeCollection ||
          row.selectability !== selectability
        ) {
          throw new Error("canonical CTF position capture authority is foreign");
        }
        if (row.normalizedMint !== input.mintUrl) continue;
        if (row.unit !== "msat") {
          throw new Error("canonical CTF position unit authority is foreign");
        }
        captured.set(row.proofId, {
          proofId: row.proofId,
          revision: row.revision,
          proofFingerprint: row.proofFingerprint,
        });
      }
      if (rows.length < POSITION_CAPTURE_PAGE_LIMIT) break;
      offset += rows.length;
    }
  }
  const targets = [...captured.values()].sort((left, right) =>
    left.proofId.localeCompare(right.proofId),
  );
  if (targets.length === 0) throw new Error("confirmed CTF position has no canonical proofs");
  return targets;
}

function ctfAsset(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
): EncryptedWalletBackupV2AssetIdentity {
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection });
  return decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl,
    unit: "msat",
    assetIdentity: `ctf:${conditionId}:${outcomeCollectionId}`,
  });
}

async function readCapturedTargets(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly targets: readonly BrowserCanonicalCtfPositionClaimTarget[];
}): Promise<CapturedTargetSet> {
  const snapshots = await readTargets(input);
  const pending = snapshots.some(({ row }) => row?.selectability === "spent");
  return classifySnapshots(snapshots, pending);
}

async function readTerminalTargets(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly targets: readonly BrowserCanonicalCtfPositionClaimTarget[];
}): Promise<CapturedTargetSet> {
  const snapshots = await readTargets(input, true);
  const pending = snapshots.some(({ row }) => row?.selectability === "spent");
  return classifySnapshots(snapshots, pending);
}

async function readTargets(
  input: {
    readonly database: BitcasterDB;
    readonly scopeId: string;
    readonly asset: EncryptedWalletBackupV2AssetIdentity;
    readonly targets: readonly BrowserCanonicalCtfPositionClaimTarget[];
  },
  allowTerminalRevision = false,
): Promise<readonly TargetSnapshot[]> {
  const byProofId = new Map<
    string,
    { rawProof: unknown; rawAuthority: unknown; rawReservation: unknown }
  >();
  for (let offset = 0; offset < input.targets.length; offset += REMOVE_PROOF_CHUNK_LIMIT) {
    const batch = input.targets.slice(offset, offset + REMOVE_PROOF_CHUNK_LIMIT);
    const keys = batch.map(({ proofId }) => [input.scopeId, proofId] as [string, string]);
    const [rawProofs, rawAuthorities, rawReservations] = await Promise.all([
      input.database.custodyProofs.bulkGet(keys),
      input.database.custodyProofBackupAuthorities.bulkGet(keys),
      input.database.custodyReservations.bulkGet(keys),
    ]);
    batch.forEach((target, index) => {
      byProofId.set(target.proofId, {
        rawProof: rawProofs[index],
        rawAuthority: rawAuthorities[index],
        rawReservation: rawReservations[index],
      });
    });
  }
  return input.targets.map((target) => {
    const current = byProofId.get(target.proofId);
    if (current === undefined) throw new Error("confirmed CTF proof target is missing");
    const { rawProof, rawAuthority, rawReservation } = current;
    if (rawProof === undefined) {
      return missingTarget(target, rawAuthority, input.scopeId, allowTerminalRevision);
    }
    const row = decodeBrowserCustodyProofRow(rawProof);
    if (
      row.scopeId !== input.scopeId ||
      row.normalizedMint !== input.asset.mintUrl ||
      row.unit !== input.asset.unit ||
      row.assetKind !== "conditional" ||
      row.conditionId === null ||
      row.outcomeCollection === null ||
      `ctf:${row.conditionId}:${deriveRootCtfOutcomeCollectionId({
        conditionId: row.conditionId,
        outcomeCollection: row.outcomeCollection,
      })}` !== input.asset.assetIdentity ||
      row.proofFingerprint !== target.proofFingerprint ||
      !targetRevisionMatches(row, target.revision, allowTerminalRevision)
    ) {
      throw new Error("confirmed CTF proof target asset, body, or revision changed");
    }
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(rawAuthority, [input.scopeId, target.proofId]),
      row,
    );
    if (
      row.reservationOperationId !== null &&
      (allowTerminalRevision || row.selectability !== "locked")
    ) {
      throw new Error("confirmed CTF proof target is reserved");
    }
    if (
      (allowTerminalRevision && rawReservation !== undefined) ||
      (!allowTerminalRevision &&
        (row.selectability === "locked") !== (rawReservation !== undefined))
    ) {
      throw new Error("confirmed CTF proof target reservation authority changed");
    }
    return {
      target,
      removalTarget: {
        proofId: target.proofId,
        proofFingerprint: target.proofFingerprint,
        proofRevision: removalProofRevision(row),
      },
      row,
      authority,
      completedMarker: null,
    };
  });
}

function missingTarget(
  target: BrowserCanonicalCtfPositionClaimTarget,
  rawAuthority: unknown,
  scopeId: string,
  allowTerminalRevision: boolean,
): TargetSnapshot {
  if (rawAuthority === undefined) throw new Error("confirmed CTF proof target is missing");
  const tableRow = decodeBrowserProofBackupAuthorityTableRow(rawAuthority);
  if (!("recordKind" in tableRow)) {
    throw new Error("confirmed CTF proof target body is missing without a removal marker");
  }
  if (
    tableRow.scopeId !== scopeId ||
    tableRow.proofId !== target.proofId ||
    tableRow.proofFingerprint !== target.proofFingerprint ||
    !markerRevisionMatches(tableRow, target.revision, allowTerminalRevision)
  ) {
    throw new Error("confirmed CTF proof removal marker is foreign");
  }
  return {
    target,
    removalTarget: {
      proofId: target.proofId,
      proofFingerprint: target.proofFingerprint,
      proofRevision: markerRemovalProofRevision(tableRow),
    },
    row: null,
    authority: null,
    completedMarker: tableRow,
  };
}

function removalProofRevision(row: BrowserCustodyProofRow): number {
  const revision = row.selectability === "pending-removal" ? row.revision - 1 : row.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("confirmed CTF removal revision is invalid");
  }
  return revision;
}

function markerRemovalProofRevision(marker: CompletedMarker): number {
  const revision =
    marker.recordKind === "completed-removal" ? marker.proofRevision - 1 : marker.proofRevision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("confirmed CTF removal marker revision is invalid");
  }
  return revision;
}

function targetRevisionMatches(
  row: BrowserCustodyProofRow,
  targetRevision: number,
  allowTerminalRevision: boolean,
): boolean {
  if (row.revision === targetRevision) return true;
  if (!allowTerminalRevision) return false;
  const increment = row.revision - targetRevision;
  return (
    increment >= 1 &&
    increment <= (row.selectability === "pending-removal" ? 3 : 2) &&
    (row.selectability === "verified-losing" || row.selectability === "pending-removal")
  );
}

function markerRevisionMatches(
  marker: CompletedMarker,
  targetRevision: number,
  allowTerminalRevision: boolean,
): boolean {
  if (marker.proofRevision === targetRevision) return true;
  if (!allowTerminalRevision) return false;
  const increment = marker.proofRevision - targetRevision;
  return increment >= 1 && increment <= (marker.recordKind === "completed-removal" ? 3 : 2);
}

function classifySnapshots(
  snapshots: readonly TargetSnapshot[],
  pending: boolean,
): CapturedTargetSet {
  const managed: BrowserCtfRemoveTarget[] = [];
  const local: BrowserCtfRemoveTarget[] = [];
  let claimRequired = false;
  for (const snapshot of snapshots) {
    if (snapshot.completedMarker !== null) {
      continue;
    }
    const row = snapshot.row!;
    const authority = snapshot.authority!;
    if (row.selectability === "selectable" || row.selectability === "locked") {
      claimRequired = true;
    }
    if (authority.backupState === "local-only" && authority.derivationLocator === null) {
      local.push(snapshot.removalTarget);
    } else {
      managed.push(snapshot.removalTarget);
    }
  }
  return {
    snapshots,
    managedTargets: managed,
    localTargets: local,
    claimRequired,
    pending,
  };
}

async function completeLocalRemoval(input: {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly targets: readonly BrowserCtfRemoveTarget[];
  readonly committedPayoutAmount: number;
  readonly observedAtMs: number | undefined;
  readonly requireProfile: () => void;
}): Promise<BrowserPortfolioRemoveResult> {
  const chunks = chunkTargets(input.targets);
  for (const targets of chunks) {
    try {
      const result = await startBrowserCtfRemove({
        database: input.database,
        scopeId: input.scopeId,
        asset: input.asset,
        targets,
        observedAtMs: input.observedAtMs,
        isCurrentProfile: () => {
          input.requireProfile();
          return true;
        },
      });
      if (result.kind === "completed") continue;
      return {
        kind: "partial",
        reason: "local-removal-pending",
        committedPayoutAmount: input.committedPayoutAmount,
        error: null,
      };
    } catch (error) {
      return {
        kind: "partial",
        reason: "local-removal-error",
        committedPayoutAmount: input.committedPayoutAmount,
        error: { code: "remove-failed", message: boundedErrorMessage(error) },
      };
    }
  }
  return {
    kind: "completed",
    committedPayoutAmount: input.committedPayoutAmount,
  };
}

async function removeManagedProofsInChunks(
  driver: {
    removeManagedProofs(input: {
      readonly asset: EncryptedWalletBackupV2AssetIdentity;
      readonly targets: readonly BrowserCtfRemoveTarget[];
    }): Promise<BrowserCtfRemoveResult>;
  },
  asset: EncryptedWalletBackupV2AssetIdentity,
  targets: readonly BrowserCtfRemoveTarget[],
): Promise<
  | { readonly kind: "completed" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string }
> {
  for (const chunk of chunkTargets(targets)) {
    try {
      const result = await driver.removeManagedProofs({ asset, targets: chunk });
      if (result.kind !== "completed") return { kind: "pending" };
    } catch (error) {
      return { kind: "error", message: boundedErrorMessage(error) };
    }
  }
  return { kind: "completed" };
}

function chunkTargets(
  targets: readonly BrowserCtfRemoveTarget[],
): readonly (readonly BrowserCtfRemoveTarget[])[] {
  const chunks: BrowserCtfRemoveTarget[][] = [];
  for (let offset = 0; offset < targets.length; offset += REMOVE_PROOF_CHUNK_LIMIT) {
    chunks.push([...targets.slice(offset, offset + REMOVE_PROOF_CHUNK_LIMIT)]);
  }
  return chunks;
}

function claimOutcome(
  claim: BrowserCanonicalCtfPositionClaimResult,
): BrowserPortfolioRemoveResult | null {
  switch (claim.kind) {
    case "completed":
      return null;
    case "stopped":
      return {
        kind: "stopped",
        reason: "winning-payout",
        committedPayoutAmount: claim.committedPayoutAmount,
      };
    case "pending":
      return {
        kind: "pending",
        reason: "claim-pending",
        committedPayoutAmount: claim.committedPayoutAmount,
      };
    case "error":
      return {
        kind: "error",
        committedPayoutAmount: claim.committedPayoutAmount,
        error: { code: "remove-failed", message: claim.error.message },
      };
  }
  throw new Error("unknown CTF claim result");
}

function removeError(committedPayoutAmount: number, message: string): BrowserPortfolioRemoveError {
  return {
    kind: "error",
    committedPayoutAmount,
    error: { code: "remove-failed", message },
  };
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Portfolio removal failed.";
  return message.length > ERROR_MESSAGE_LIMIT
    ? `${message.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`
    : message;
}
